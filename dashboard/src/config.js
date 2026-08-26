export const API_URL = import.meta.env.VITE_API_URL || ""

if (API_URL && !API_URL.endsWith("/")) {
  console.warn("VITE_API_URL deve terminar com '/' para evitar URLs quebradas.")
}
