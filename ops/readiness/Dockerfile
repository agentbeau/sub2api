FROM golang:1.26.10-bookworm AS builder
ENV GOTOOLCHAIN=local
WORKDIR /src
RUN git init -q . && git remote add origin https://github.com/router-for-me/CLIProxyAPI.git && git fetch -q --depth 1 origin 8bba7a77c6bcbfd993516d26606bfecaa4ff49d0 && git checkout -q 8bba7a77c6bcbfd993516d26606bfecaa4ff49d0 && test "$(git rev-parse HEAD)" = 8bba7a77c6bcbfd993516d26606bfecaa4ff49d0
COPY container/activity /src/internal/sub2apiactivity
COPY container/patch-cpa /build/patch-cpa
COPY container/readiness-test/service_readiness_window_repro_test.go /src/sdk/cliproxy/service_readiness_window_repro_test.go
RUN go test /build/patch-cpa/main.go /build/patch-cpa/main_test.go && go run /build/patch-cpa/main.go /src && go test -race ./internal/sub2apiactivity && go test ./sdk/cliproxy -run '^(TestReadinessWindowHealthIsNotModelReady|TestInitializationReadinessEmptyAndFailedBootstrap)$' -count=1
RUN CGO_ENABLED=1 GOOS=linux go build -buildvcs=false -trimpath -ldflags="-s -w -X main.Version=v8.0.67 -X main.Commit=8bba7a77c6bcbfd993516d26606bfecaa4ff49d0" -o /out/CLIProxyAPI ./cmd/server/
FROM registry.cloudflare.com/c05a228a4bebdc8625e8f42d405475a7/gateway-engine@sha256:6a8959018529d6d505278eae7e346d550fbd511da3ba069d7be11871a05a47f1
COPY --from=builder /out/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
