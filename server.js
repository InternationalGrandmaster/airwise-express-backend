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

// Helper function to validate sensor data
const validateSensorData = (data) => {
  const { temperature, humidity, pm25, pm10, co2, tvoc } = data;
  const isValid = (value, min, max) => value === null || value === undefined || (value >= min && value <= max);

  return (
    isValid(temperature, -50, 50) && // Temperature range: -50°C to 50°C
    isValid(humidity, 0, 100) &&     // Humidity range: 0% to 100%
    isValid(pm25, 0, 500) &&         // PM2.5 range: 0 to 500 µg/m³
    isValid(pm10, 0, 500) &&         // PM10 range: 0 to 500 µg/m³
    isValid(co2, 0, 5000) &&         // CO2 range: 0 to 5000 ppm
    isValid(tvoc, 0, 1000)           // TVOC range: 0 to 1000 ppb
  );
};

// Helper function to resolve conflicts between readings
const resolveConflicts = (existingReading, newReading) => {
  const resolveValue = (existing, incoming) => {
    if (existing === null || existing === undefined) return incoming;
    if (incoming === null || incoming === undefined) return existing;
    return (existing + incoming) / 2; // Average the values
  };

  return {
    temperature: resolveValue(existingReading.temperature, newReading.temperature),
    humidity: resolveValue(existingReading.humidity, newReading.humidity),
    pm25: resolveValue(existingReading.pm25, newReading.pm25),
    pm10: resolveValue(existingReading.pm10, newReading.pm10),
    co2: resolveValue(existingReading.co2, newReading.co2),
    tvoc: resolveValue(existingReading.tvoc, newReading.tvoc),
  };
};

// G-counter to track valid readings per client
const clientReadingsCounter = {};

// PN-counter to track readings per device
const deviceReadingsCounter = {};

// Helper function to update G-counter
const updateGCounter = (clientId) => {
  if (!clientReadingsCounter[clientId]) {
    clientReadingsCounter[clientId] = 0;
  }
  clientReadingsCounter[clientId]++;
};

// Helper function to update PN-counter
const updatePNCounter = (deviceId, increment = true) => {
  if (!deviceReadingsCounter[deviceId]) {
    deviceReadingsCounter[deviceId] = { p: 0, n: 0 };
  }
  if (increment) {
    deviceReadingsCounter[deviceId].p++;
  } else {
    deviceReadingsCounter[deviceId].n++;
  }
};

// Helper function to calculate weighted average
const calculateWeightedAverage = (readings) => {
  let totalWeight = 0;
  let weightedSum = 0;

  readings.forEach(({ value, clientId }) => {
    const weight = clientReadingsCounter[clientId] || 1; // Default weight is 1
    weightedSum += value * weight;
    totalWeight += weight;
  });

  return totalWeight > 0 ? weightedSum / totalWeight : null;
};

// Helper function to generate dummy data for simulation
const generateDummyData = () => {
  return {
    temperature: +(20 + Math.random() * 10).toFixed(2), // 20-30°C
    humidity: +(40 + Math.random() * 30).toFixed(2),    // 40-70%
    pm25: +(5 + Math.random() * 30).toFixed(2),         // 5-35 µg/m³
    pm10: +(10 + Math.random() * 40).toFixed(2),        // 10-50 µg/m³
    co2: +(400 + Math.random() * 600).toFixed(0),       // 400-1000 ppm
    tvoc: +(50 + Math.random() * 250).toFixed(0),       // 50-300 ppb
  };
};

// POST /readings endpoint
app.post('/readings', async (req, res) => {
  const { device_id, client_id, pm2_5, client_timestamp, ...sensorData } = req.body; // Destructure common fields

  // Basic validation
  if (!device_id) {
    return res.status(400).json({ error: 'Missing device_id field.' });
  }
  if (Object.values(sensorData).every(val => val === null || val === undefined) && !pm2_5) {
      return res.status(400).json({ error: 'Received reading data contains no sensor values.' });
  }

  // Validate incoming data
  if (!validateSensorData(sensorData)) {
    return res.status(400).json({ error: 'Invalid sensor data.' });
  }

  // Update G-counter for the client
  updateGCounter(client_id);

  // Update PN-counter for the device
  updatePNCounter(device_id);

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

    // Check for recent readings from the same device
    const recentReadings = await prisma.sensorReading.findMany({
      where: {
        device: { deviceId: device_id },
        timestamp: {
          gte: new Date(Date.now() - 5 * 60 * 1000), // Last 5 minutes
        },
      },
      orderBy: { timestamp: 'desc' },
    });

    let resolvedData = sensorData;

    // Resolve conflicts using LWW-Register and weighted average
    if (recentReadings.length > 0) {
      const latestReading = recentReadings[0];
      resolvedData = {
        ...resolvedData,
        temperature: calculateWeightedAverage([
          { value: latestReading.temperature, clientId: latestReading.clientId },
          { value: sensorData.temperature, clientId: client_id },
        ]),
        humidity: calculateWeightedAverage([
          { value: latestReading.humidity, clientId: latestReading.clientId },
          { value: sensorData.humidity, clientId: client_id },
        ]),
        pm25: calculateWeightedAverage([
          { value: latestReading.pm25, clientId: latestReading.clientId },
          { value: sensorData.pm25, clientId: client_id },
        ]),
        pm10: calculateWeightedAverage([
          { value: latestReading.pm10, clientId: latestReading.clientId },
          { value: sensorData.pm10, clientId: client_id },
        ]),
        co2: calculateWeightedAverage([
          { value: latestReading.co2, clientId: latestReading.clientId },
          { value: sensorData.co2, clientId: client_id },
        ]),
        tvoc: calculateWeightedAverage([
          { value: latestReading.tvoc, clientId: latestReading.clientId },
          { value: sensorData.tvoc, clientId: client_id },
        ]),
      };
    }

    // 2. Create the sensor reading, linking it to the device's primary key (device.id)
    const newReading = await prisma.sensorReading.create({
      data: {
        deviceIdRef: device.id, // Link using the integer primary key
        clientTimestamp: client_timestamp ? new Date(client_timestamp) : null, // Convert if provided
        ...resolvedData,
        pm25: pm2_5, // Handle potential alias pm2_5 from input
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
    // Remove deviceIdRef if i don't want it in the response
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

    // Check if data is insufficient
    const totalReadings = (deviceReadingsCounter[deviceId]?.p || 0) - (deviceReadingsCounter[deviceId]?.n || 0);
    if (totalReadings < 5) {
      return res.status(200).json({
        message: 'Insufficient data. Switching to simulation mode.',
        simulatedData: generateDummyData(), // Use simulation logic
      });
    }

    if (readings.length === 0) {
      return res.status(404).json({ error: 'No data available for this device.' });
    }

    // Interpolate missing data if necessary
    const interpolatedReadings = readings.map((reading, index, arr) => {
      if (index === 0 || index === arr.length - 1) return reading; // Skip first and last
      const prev = arr[index - 1];
      const next = arr[index + 1];

      return {
        ...reading,
        temperature: reading.temperature ?? (prev.temperature + next.temperature) / 2,
        humidity: reading.humidity ?? (prev.humidity + next.humidity) / 2,
        pm25: reading.pm25 ?? (prev.pm25 + next.pm25) / 2,
        pm10: reading.pm10 ?? (prev.pm10 + next.pm10) / 2,
        co2: reading.co2 ?? (prev.co2 + next.co2) / 2,
        tvoc: reading.tvoc ?? (prev.tvoc + next.tvoc) / 2,
      };
    });

    // Add the string deviceId back to each reading for consistency
    const responseReadings = interpolatedReadings.map(r => {
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
