-- CreateTable
CREATE TABLE "Device" (
    "id" SERIAL NOT NULL,
    "deviceId" TEXT NOT NULL,
    "name" TEXT,
    "locationDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensor_readings" (
    "id" SERIAL NOT NULL,
    "device_id_ref" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientTimestamp" TIMESTAMP(3),
    "temperature" DOUBLE PRECISION,
    "humidity" DOUBLE PRECISION,
    "pm25" DOUBLE PRECISION,
    "pm10" DOUBLE PRECISION,
    "co2" DOUBLE PRECISION,
    "tvoc" DOUBLE PRECISION,

    CONSTRAINT "sensor_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceId_key" ON "Device"("deviceId");

-- CreateIndex
CREATE INDEX "sensor_readings_device_id_ref_timestamp_idx" ON "sensor_readings"("device_id_ref", "timestamp");

-- AddForeignKey
ALTER TABLE "sensor_readings" ADD CONSTRAINT "sensor_readings_device_id_ref_fkey" FOREIGN KEY ("device_id_ref") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
