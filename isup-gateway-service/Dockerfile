FROM debian:bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    build-essential \
    libcurl4-openssl-dev \
    libc6 \
    libstdc++6 \
    openssl \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY include /app/include
COPY lib /app/lib
COPY main.cpp /app/main.cpp

# Compile with g++ using Hikvision official native Linux64 libraries
RUN g++ -O2 -I/app/include /app/main.cpp -L/app/lib -lHCISUPCMS -lHCISUPAlarm -lcurl -lpthread -Wl,-rpath=/app/lib -o /app/isup_gateway

ENV LD_LIBRARY_PATH="/app/lib:$LD_LIBRARY_PATH"

EXPOSE 7660

CMD ["/app/isup_gateway"]
