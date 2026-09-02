import { Link } from "react-router-dom";
import { computeAlerts } from "../utils/alerts";
import {
  bytesToGB,
  formatPercent,
  formatUptime,
  fmtDate
} from "../utils/formatters";
import { getUptimeStatus, UPTIME_STATUS, uptimeStatusLabel } from "../utils/uptime";
import { isVersionNewer } from "../utils/version";

function MetricBar({ value }) {
  const pct = Math.max(0, Math.min(100, value || 0));
  const cls = pct >= 90 ? "crit" : pct >= 80 ? "warn" : "";
  return (
    <div className="bar">
      <div className={`bar-fill ${cls}`} style={{ width: pct + "%" }}></div>
    </div>
  );
}

export default function ComputerCard({ c, latestVersion, onOpen, onDelete, hasActiveAlert = false }) {
  const online = c.status === "online";
  const { alerts } = computeAlerts(c);
  const uptimeStatus = getUptimeStatus(c.uptime);
  const requiresAttention = hasActiveAlert || alerts.length > 0 || [UPTIME_STATUS.ATTENTION, UPTIME_STATUS.REBOOT_RECOMMENDED].includes(uptimeStatus);
  const updateAvailable = isVersionNewer(latestVersion, c.agentVersion);

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

  const openDetails = () => onOpen?.(c.id);

  return (
    <article
      className={`card compact-card ${cardClass}`}
      onClick={openDetails}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") openDetails();
      }}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className="hostname">{c.hostname || "(sem nome)"}</div>
      <div className="card-status-row">
        <span className={online ? "status-pill online" : "status-pill offline"}>
          {online ? "Online" : "Offline"}
        </span>
        <span className="card-ip">{c.ip || "IP não informado"}</span>
      </div>
      {requiresAttention && <div className={`card-attention ${uptimeStatus === UPTIME_STATUS.REBOOT_RECOMMENDED ? "reboot" : ""}`}><span aria-hidden="true">!</span>{uptimeStatus === UPTIME_STATUS.REBOOT_RECOMMENDED ? "Reinício recomendado" : uptimeStatus === UPTIME_STATUS.ATTENTION ? `Uptime: ${formatUptime(c.uptime)}` : "Requer atenção"}</div>}

      <div className="card-metrics">
        <div className="card-metric"><span>CPU</span><strong>{formatPercent(c.cpuUso)}</strong><MetricBar value={c.cpuUso || 0} /></div>
        <div className="card-metric"><span>RAM</span><strong>{formatPercent(ramPct)}</strong><MetricBar value={ramPct || 0} /></div>
        <div className="card-metric"><span>Disco</span><strong>{formatPercent(discoPct)} usado</strong><MetricBar value={discoPct || 0} /></div>
      </div>

      {alerts.length > 0 && <div className="card-alert-summary">⚠ {alerts.length} alerta{alerts.length > 1 ? "s" : ""}</div>}

      <div className="agent-line">
        <span className="agent-version">
          Agent v{c.agentVersion || "?"}
        </span>
        {updateAvailable && (
          <span className="update-available">
            ⚠ Nova versão: v{latestVersion}
          </span>
        )}
      </div>

      <div className="card-actions">
        {onOpen ? <button type="button" className="details-link" onClick={(event) => { event.stopPropagation(); openDetails(); }}>Ver detalhes</button> : <Link className="details-link" to={`/computadores/${c.id}`}>Ver detalhes</Link>}
        {updateAvailable && online && (
          <Link className="btn-update" onClick={(event) => event.stopPropagation()} to={`/computadores/${c.id}`}>
            Atualizar
          </Link>
        )}
        {!online && onDelete && <button type="button" className="btn-delete-subtle" onClick={(event) => { event.stopPropagation(); onDelete(c); }}>Excluir</button>}
      </div>
      <div className="card-uptime"><span>{online ? "Uptime" : "Último uptime registrado"}</span><strong>{formatUptime(c.uptime)}</strong>{uptimeStatus !== UPTIME_STATUS.UNKNOWN && uptimeStatus !== UPTIME_STATUS.NORMAL && <small>{uptimeStatusLabel(uptimeStatus)}</small>}</div>
      {!online && <div className="card-last-seen">Última comunicação: {fmtDate(c.ultimaConexao)}</div>}
    </article>
  );
}
