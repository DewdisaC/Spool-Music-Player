import React from "react";
import ReactDOM from "react-dom/client";
import SpoolApp from "./SpoolApp.jsx";

/**
 * Database-backed storage adapter.
 * SpoolApp keeps its simple async key/value interface, while the data is
 * persisted by the Node server in SQLite instead of browser localStorage.
 */
function installStorageAdapter() {
  const prefix = (shared) => `spool:${shared ? "shared" : "local"}:`;

  window.storage = {
    async get(key, shared = false) {
      const res = await fetch(`/api/storage/${encodeURIComponent(prefix(shared) + key)}`);
      if (!res.ok) throw new Error(`Storage read failed (${res.status})`);
      return res.json();
    },
    async set(key, value, shared = false) {
      const res = await fetch(`/api/storage/${encodeURIComponent(prefix(shared) + key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error(`Storage write failed (${res.status})`);
      return res.json();
    },
    async delete(key, shared = false) {
      const res = await fetch(`/api/storage/${encodeURIComponent(prefix(shared) + key)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Storage delete failed (${res.status})`);
      return res.json();
    },
  };
}

installStorageAdapter();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SpoolApp />
  </React.StrictMode>
);
