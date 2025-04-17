// server.js
require('dotenv').config();
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const cors = require('cors'); // Import cors

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 8000;

// --- Middleware ---
app.use(cors()); // Enable CORS for all origins (simplest for development)
/*
// OR, more specific configuration:
app.use(cors({
  origin: 'http://localhost:5173', // Allow only the frontend origin
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Allowed methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
}));
*/

app.use(express.json());
// --- Logging Middleware (Optional but helpful) ---
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// --- Routes ---

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to the Airwise Express API!' });
});

// POST /readings endpoint
app.post('/readings', async (req, res) => {
  const { device_id, pm2_5, client_timestamp, ...sensorData } = req.body; // Destructure common fields

  // Basic validation
  if (!device_id) {
    return res.status(400).json({ error: 'Missing device_id field.' });
  }
  if (Object.values(sensorData).every(val => val === null || val === undefined) && !pm2_5) {
      return res.status(400).json({ error: 'Received reading data contains no sensor values.' });
  }


  try {
    // 1. Get or create the device using Prisma's upsert
    const device = await prisma.device.upsert({
      where: { deviceId: device_id }, // Find device by its unique string ID
      update: {
        // lastSeenAt is handled by @updatedAt
      },
      create: {
        deviceId: device_id,
        // name: null, // Can add name/location later if needed
        // locationDescription: null,
      },
    });

    // 2. Create the sensor reading, linking it to the device's primary key (device.id)
    const newReading = await prisma.sensorReading.create({
      data: {
        deviceIdRef: device.id, // Link using the integer primary key
        clientTimestamp: client_timestamp ? new Date(client_timestamp) : null, // Convert if provided
        temperature: sensorData.temperature,
        humidity: sensorData.humidity,
        pm25: pm2_5, // Handle potential alias pm2_5 from input
        pm10: sensorData.pm10,
        co2: sensorData.co2,
        tvoc: sensorData.tvoc,
        // 'timestamp' field uses @default(now())
      },
      // Include the related device info in the response (optional)
      // include: {
      //   device: { select: { deviceId: true } }
      // }
    });

    // Add the string deviceId back for consistency with previous API response shape
    const responseReading = {
        ...newReading,
        device_id: device_id // Add the string ID client expects
    }
    // Remove deviceIdRef if you don't want it in the response
    delete responseReading.deviceIdRef;


    console.log(`Stored reading ID ${newReading.id} for device ${device_id} (PK: ${device.id})`);
    res.status(201).json(responseReading);

  } catch (error) {
    console.error('Error processing /readings POST:', error);
    // Check for specific Prisma errors if needed (e.g., validation errors)
    res.status(500).json({ error: 'Failed to store sensor reading.', details: error.message });
  }
});

// GET /readings/device/:deviceId endpoint
app.get('/readings/device/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  // Get limit from query param, default to 10, ensure it's a number
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0 || limit > 1000) {
    limit = 10; // Default or clamp if invalid
  }

  try {
    // Find readings for the device with the given string ID
    // Use include to potentially get device info if needed, or just filter directly
    const readings = await prisma.sensorReading.findMany({
      where: {
        device: { // Filter based on the related device's string ID
          deviceId: deviceId,
        },
      },
      orderBy: {
        timestamp: 'desc', // Get the latest readings first
      },
      take: limit, // Apply the limit
    });

    if (!readings) {
        // findMany returns empty array if not found, doesn't throw error typically
        return res.status(404).json({ error: `No readings found for device ID '${deviceId}' or device does not exist.` });
    }

    // Add the string deviceId back to each reading for consistency
    const responseReadings = readings.map(r => {
        const readingWithId = { ...r, device_id: deviceId };
        delete readingWithId.deviceIdRef; // Clean up internal foreign key
        return readingWithId;
    });


    console.log(`Found ${responseReadings.length} readings for device ${deviceId}`);
    res.status(200).json(responseReadings);

  } catch (error) {
    console.error(`Error processing GET /readings/device/${deviceId}:`, error);
    res.status(500).json({ error: 'Failed to retrieve sensor readings.', details: error.message });
  }
});

// --- Global Error Handler (Optional - Basic Example) ---
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).send('Something broke!');
});


// --- Start Server ---
async function main() {
  try {
    await prisma.$connect(); // Explicitly connect Prisma Client
    console.log("Database connection established.");
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
      console.error("Failed to connect to database:", error);
      process.exit(1); // Exit if DB connection fails
  }
}

main()
  .catch((e) => {
    console.error("Error starting server:", e);
    process.exit(1);
  })
  .finally(async () => {
    // Ensure Prisma Client disconnects on shutdown (e.g., Ctrl+C)
    // process.on('SIGINT', async () => { // Handling shutdown signals more robustly
    //     await prisma.$disconnect();
    //     process.exit(0);
    // });
    // await prisma.$disconnect(); // Simple disconnect in finally might be enough for basic cases
  });

// Graceful shutdown handling (more robust)
const gracefulShutdown = async (signal) => {
    console.log(`\nReceived ${signal}. Closing server and database connection.`);
    // You might need to explicitly close the server instance here if needed
    await prisma.$disconnect();
    console.log("Database connection closed.");
    process.exit(0);
};
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));