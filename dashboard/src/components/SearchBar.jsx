export default function SearchBar({ value, onChange, label = 'Buscar computadores' }) {
  return (
    <div className="search">
      <label className="sr-only" htmlFor="computer-search">{label}</label>
      <input
        id="computer-search"
        type="text"
        placeholder="Buscar por apelido, hostname, equipamento ou IP..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
