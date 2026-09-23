// hub-sdk's telemetry loads OpenTelemetry for Node only when TELEMETRY_ENABLED=true;
// the Worker never enables it, so the bundle maps those imports to this empty module.
export {}
