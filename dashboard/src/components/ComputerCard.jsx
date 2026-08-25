import { Link } from "react-router-dom";
import { computeAlerts } from "../utils/alerts";
import {
  bytesToGB,
  formatUptime,
  formatPercent,
  sistemaLabel,
  fmtDate
} from "../utils/formatters";

function MetricBar({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const cls = pct >= 90 ? "crit" : pct >= 80 ? "warn" : "";
  return (
    <div className="bar">
      <div className={`bar-fill ${cls}`} style={{ width: pct + "%" }}></div>
    </div>
  );
}

export default function ComputerCard({ c }) {
  const online = c.status === "online";
  const { alerts } = computeAlerts(c);

  const ramPct =
    c.ramTotal && c.ramUsada != null
      ? Math.round((c.ramUsada / c.ramTotal) * 100)
      : null;
  const discoPct =
    c.discoTotal && c.discoLivre != null
      ? Math.round(((c.discoTotal - c.discoLivre) / c.discoTotal) * 100)
      : null;

  const hasCritical = alerts.some((a) => a.severity === "critical");
  const hasWarn = alerts.some((a) => a.severity === "warn");
  const cardClass = !online
    ? "offline-card"
    : hasCritical
    ? "critical-card"
    : hasWarn
    ? "warn-card"
    : "online-card";

  return (
    <div className={`card ${cardClass}`}>
      <div className="hostname">{c.hostname || "(sem nome)"}</div>
      <div className="sub">
        Usuário: {c.usuario || "-"} | IP: {c.ip || "-"} | Sistema:{" "}
        {sistemaLabel(c.sistema)}
      </div>
      <div>
        Status:{" "}
        <span className={online ? "online" : "offline"}>
          {online ? "Online" : "Offline"}
        </span>
      </div>

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${a.severity}`}>
              ⚠ {a.msg}
            </div>
          ))}
        </div>
      )}

      {!online && (
        <div className="offline-info">
          Últimos dados conhecidos. Última conexão: {fmtDate(c.ultimaConexao)}
        </div>
      )}

      <div className="metric">
        <div className="metric-label">CPU</div>
        <div className="metric-value">{formatPercent(c.cpuUso)}</div>
        <MetricBar value={c.cpuUso || 0} />
      </div>

      <div className="metric">
        <div className="metric-label">RAM</div>
        <div className="metric-value">
          {bytesToGB(c.ramUsada)} / {bytesToGB(c.ramTotal)} (
          {formatPercent(ramPct)})
        </div>
        <MetricBar value={ramPct || 0} />
      </div>

      <div className="metric">
        <div className="metric-label">Disco C:</div>
        <div className="metric-value">
          {bytesToGB(c.discoLivre)} livres de {bytesToGB(c.discoTotal)} (
          {formatPercent(discoPct)} usado)
        </div>
        <MetricBar value={discoPct || 0} />
      </div>

      <div className="metric">
        <div className="metric-label">Ligado há</div>
        <div className="metric-value">{formatUptime(c.uptime)}</div>
      </div>

      <div className="card-actions">
        <Link className="details-link" to={`/computadores/${c.id}`}>
          Ver detalhes
        </Link>
      </div>
    </div>
  );
}
