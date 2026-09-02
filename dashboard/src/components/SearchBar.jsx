export default function SearchBar({ value, onChange }) {
  return (
    <div className="search">
      <input
        type="text"
        placeholder="Buscar por apelido, hostname, equipamento ou IP..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
