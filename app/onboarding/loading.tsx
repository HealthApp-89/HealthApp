export default function Loading() {
  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 16 }}>
      <div style={{ height: 12, width: 100, background: "rgba(255,255,255,0.05)", borderRadius: 4 }} />
      <div style={{ height: 28, width: "60%", background: "rgba(255,255,255,0.06)", borderRadius: 6, marginTop: 8 }} />
      <div style={{ height: 4, width: "100%", background: "rgba(255,255,255,0.05)", borderRadius: 4, marginTop: 14 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 24 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ height: 60, background: "rgba(255,255,255,0.04)", borderRadius: 8 }} />
        ))}
      </div>
    </div>
  );
}
