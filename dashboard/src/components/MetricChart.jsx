import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid
} from "recharts";
import { fmtDate } from "../utils/formatters";

export default function MetricChart({ title, data, dataKey, color }) {
  if (!data || data.length === 0) {
    return (
      <div className="chart-block">
        <h4>{title}</h4>
        <p className="muted">
          Ainda não há histórico suficiente para este período.
        </p>
      </div>
    );
  }

  const formatter = (v) => [`${v != null ? v : "-"}%`, title];

  return (
    <div className="chart-block">
      <h4>{title}</h4>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey="coletadoEm"
            tickFormatter={(v) =>
              new Date(v).toLocaleString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit"
              })
            }
            stroke="#94a3b8"
            fontSize={11}
            minTickGap={30}
          />
          <YAxis domain={[0, 100]} stroke="#94a3b8" fontSize={11} />
          <Tooltip
            labelFormatter={(v) => fmtDate(v)}
            formatter={formatter}
            contentStyle={{
              background: "#1e293b",
              border: "1px solid #334155",
              borderRadius: 6,
              color: "#e2e8f0"
            }}
          />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
