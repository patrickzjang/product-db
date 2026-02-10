export function isMaintenanceMode(): boolean {
  const raw = (process.env.MAINTENANCE_MODE || "").toLowerCase().trim();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
