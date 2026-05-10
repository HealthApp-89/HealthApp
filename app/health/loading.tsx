import { Card } from "@/components/ui/Card";
import { COLOR } from "@/lib/ui/theme";

export default function Loading() {
  return (
    <div style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "12px" }}>
      <Card>
        <div style={{ height: "16px", background: COLOR.surfaceAlt, borderRadius: "6px", marginBottom: "12px", width: "40%" }} />
        <div style={{ height: "120px", background: COLOR.surfaceAlt, borderRadius: "10px" }} />
      </Card>
      <Card>
        <div style={{ height: "16px", background: COLOR.surfaceAlt, borderRadius: "6px", marginBottom: "12px", width: "60%" }} />
        <div style={{ height: "240px", background: COLOR.surfaceAlt, borderRadius: "10px" }} />
      </Card>
    </div>
  );
}
