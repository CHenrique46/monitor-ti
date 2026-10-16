export const API_URL = import.meta.env.VITE_API_URL || ""
export const CERTIFICATE_PORTAL_READ_ONLY = import.meta.env.VITE_CERTIFICATE_PORTAL_READ_ONLY === "true"

if (API_URL && !API_URL.endsWith("/")) {
  console.warn("VITE_API_URL deve terminar com '/' para evitar URLs quebradas.")
}
