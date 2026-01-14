#!/bin/bash

CONTAINER_NAME=$1

if [ -z "$CONTAINER_NAME" ]; then
    # No container specified - full reset
    echo "=========================================="
    echo "Resetting the Data Pipeline Environment"
    echo "=========================================="

    echo "[INFO] Stopping and removing all containers..."
    docker compose down -v

    echo "[INFO] Restarting the services..."
    ./run.sh
else
    # Container specified - reset only that container
    echo "=========================================="
    echo "Resetting Container: $CONTAINER_NAME"
    echo "=========================================="

    # Check if container exists
    if ! docker compose ps -a --format '{{.Name}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "[ERROR] Container '$CONTAINER_NAME' not found in this project."
        echo ""
        echo "Available containers:"
        docker compose ps -a --format '{{.Name}}'
        exit 1
    fi

    echo "[INFO] Stopping container: $CONTAINER_NAME..."
    docker compose stop "$CONTAINER_NAME"

    echo "[INFO] Removing container: $CONTAINER_NAME..."
    docker compose rm -f "$CONTAINER_NAME"

    echo "[INFO] Rebuilding container: $CONTAINER_NAME..."
    docker compose build "$CONTAINER_NAME"

    echo "[INFO] Starting container: $CONTAINER_NAME..."
    docker compose up -d "$CONTAINER_NAME"

    echo ""
    echo "[INFO] Waiting for container to be ready..."
    sleep 5

    # Show container status
    echo ""
    echo "[INFO] Container status:"
    docker compose ps "$CONTAINER_NAME"

    echo ""
    echo "=========================================="
    echo "[INFO] Container '$CONTAINER_NAME' has been reset!"
    echo "=========================================="
fi
