# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Build:  docker build -t glowstack:dev .
# Run:    docker run --rm -v ./config:/config:ro -v glowstack-data:/data \
#           -p 8080:8080 glowstack:dev
# See the "Container" section of README.md for ports, privileges and networks.

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static binaries: no libc in the runtime image. -trimpath and -s -w keep them
# reproducible and small.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w" -o /out/ ./cmd/glowstack ./cmd/glowctl ./cmd/fakewled
# /data is created here because the runtime image has no shell to mkdir with.
# 65532 is distroless's "nonroot" user.
RUN install -d -o 65532 -g 65532 /out/data

# distroless/static rather than alpine: the binaries are static, so all the
# runtime needs is CA certificates, tzdata and a non-root user, and distroless
# has exactly those with no shell or package manager to patch. The cost is no
# shell in the container; use `docker run --entrypoint fakewled` or a debug
# sidecar instead of `docker exec sh`.
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="glowstack" \
      org.opencontainers.image.description="Renders every pixel of a large addressable LED installation and streams frames to WLED controllers over DDP" \
      org.opencontainers.image.source="https://github.com/jerejones/glowstack" \
      org.opencontainers.image.url="https://github.com/jerejones/glowstack" \
      org.opencontainers.image.licenses="MPL-2.0"

COPY --from=build /out/glowstack /out/glowctl /out/fakewled /usr/local/bin/
COPY --from=build --chown=65532:65532 /out/data /data

# /config is mounted read-only by the operator and holds site data, which is
# never built into the image. /data holds state.json, anchors.yaml and
# presets.saved.yaml.
VOLUME ["/config", "/data"]

# 8080: control API (/api/v1/) and live map (/map/).
# 80: the WLED-compatible devices, which bind :80 on their own IPs. The image
# runs as non-root. Docker (20.10+) already sets
# net.ipv4.ip_unprivileged_port_start=0 in container namespaces, so binding :80
# works without capabilities (checked with fakewled). Where the runtime doesn't
# (some Podman and hardened setups), pass
# `--sysctl net.ipv4.ip_unprivileged_port_start=0`, or fall back to `--user 0`
# with `--cap-drop ALL --cap-add NET_BIND_SERVICE`.
EXPOSE 8080 80

USER 65532:65532

# glowctl talks to 127.0.0.1:8080. Override with --http on the command line
# and GLOWSTACK_URL in the environment if you move the port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["glowctl", "status"]

ENTRYPOINT ["glowstack", "--config", "/config", "--data", "/data"]
CMD ["--http", ":8080"]
