export default function SearchBar({ value, onChange }) {
  return (
    <div className="search">
      <input
        type="text"
        placeholder="Buscar por hostname, usuário ou IP..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
