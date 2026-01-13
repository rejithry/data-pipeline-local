#!/bin/bash

echo "=========================================="
echo "Resetting the Data Pipeline Environment"
echo "=========================================="

echo "[INFO] Stopping and removing all containers..."
docker compose down -v

echo "[INFO] Restarting the services..."
./run.sh
