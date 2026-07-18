export function Showcase() {
  const templates = [
    {
      id: "classic-academic",
      name: "Classic Academic",
      badge: "Chicago / Oxford",
      num: 1,
      accent: "#404040",
      bg: "#ffffff",
      chapterLabel: "CHAPTER 3",
      chapterLabelStyle: { fontFamily: "'Inter', sans-serif", fontSize: 9, letterSpacing: "0.15em", color: "#595959", textAlign: "center" as const, fontWeight: 500 },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#1a1a1a", textAlign: "center" as const, lineHeight: 1.25 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 12.5, fontWeight: 700, color: "#1a1a1a", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11, lineHeight: 1.6, color: "#1a1a1a", textIndent: "28px", textAlign: "justify" as const },
      dividerColor: "#c8c8c8", showDivider: true, dividerWidth: "50%", dividerAlign: "center" as const,
      paragraphGap: 0, dropCapColor: "#404040",
    },
    {
      id: "modern-business",
      name: "Modern Business",
      badge: "Portfolio / Penguin",
      num: 2,
      accent: "#1b3d6e",
      bg: "#ffffff",
      chapterLabel: "CHAPTER 3",
      chapterLabelStyle: { fontFamily: "'Inter', sans-serif", fontSize: 9, letterSpacing: "0.12em", color: "#1b3d6e", fontWeight: 700, textAlign: "left" as const },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, color: "#0d0d0d", textAlign: "left" as const, lineHeight: 1.2 },
      sectionStyle: { fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 700, color: "#0d0d0d", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11.5, lineHeight: 1.72, color: "#0d0d0d", textAlign: "justify" as const },
      dividerColor: "#1b3d6e", showDivider: true, dividerWidth: "100%", dividerAlign: "left" as const,
      paragraphGap: 10, dropCapColor: "#1b3d6e", underTitle: { height: 2, color: "#1b3d6e" },
    },
    {
      id: "devotional",
      name: "Devotional",
      badge: "Zondervan / Nelson",
      num: 3,
      accent: "#7a3d00",
      bg: "#fffdf8",
      chapterLabel: "Chapter 3",
      chapterLabelStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11, fontStyle: "italic", color: "#7a3d00", textAlign: "center" as const },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 700, color: "#190f00", textAlign: "center" as const, lineHeight: 1.25 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 13, fontWeight: 700, color: "#190f00", textAlign: "center" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 12, lineHeight: 1.75, color: "#190f00", textAlign: "justify" as const },
      dividerColor: "#c49060", showDivider: true, dividerWidth: "50%", dividerAlign: "center" as const,
      paragraphGap: 12, dropCapColor: "#7a3d00",
    },
    {
      id: "popular-nonfiction",
      name: "Popular Nonfiction",
      badge: "Hay House / Random House",
      num: 4,
      accent: "#bf3a06",
      bg: "#ffffff",
      chapterLabel: "03",
      chapterLabelStyle: { fontFamily: "'Inter', sans-serif", fontSize: 48, fontWeight: 900, color: "#bf3a06", textAlign: "left" as const, lineHeight: 1 },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 22, fontWeight: 700, color: "#0d0d0d", textAlign: "left" as const, lineHeight: 1.2 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 13, fontWeight: 700, color: "#0d0d0d", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11.5, lineHeight: 1.68, color: "#0d0d0d", textAlign: "justify" as const },
      dividerColor: "#d9d9d9", showDivider: true, dividerWidth: "70%", dividerAlign: "left" as const,
      paragraphGap: 9, dropCapColor: "#bf3a06",
    },
    {
      id: "premium-literary",
      name: "Premium Literary",
      badge: "Knopf / Farrar Straus",
      num: 5,
      accent: "#4d4d4d",
      bg: "#ffffff",
      chapterLabel: "III",
      chapterLabelStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11, fontStyle: "italic", color: "#4d4d4d", textAlign: "center" as const, letterSpacing: "0.25em" },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 400, color: "#1a1a1a", textAlign: "center" as const, lineHeight: 1.3 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11.5, fontStyle: "italic", color: "#333333", textAlign: "center" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11, lineHeight: 1.62, color: "#1a1a1a", textIndent: "36px", textAlign: "justify" as const },
      dividerColor: "#bfbfbf", showDivider: false, dividerWidth: "40%", dividerAlign: "center" as const,
      paragraphGap: 0, dropCapColor: "#4d4d4d",
    },
    {
      id: "pastoral-ministry",
      name: "Pastoral Ministry",
      badge: "Baker / Whitaker House",
      num: 6,
      accent: "#6b1f2a",
      bg: "#fdfaf7",
      chapterLabel: "CHAPTER THREE",
      chapterLabelStyle: { fontFamily: "'Inter', sans-serif", fontSize: 8.5, letterSpacing: "0.18em", color: "#6b1f2a", textAlign: "center" as const, fontWeight: 600 },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, color: "#1a0408", textAlign: "center" as const, lineHeight: 1.25 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 13.5, fontWeight: 700, color: "#1a0408", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 12.5, lineHeight: 1.82, color: "#1a0408", textAlign: "justify" as const },
      dividerColor: "#b89070", showDivider: true, dividerWidth: "50%", dividerAlign: "center" as const,
      paragraphGap: 12, dropCapColor: "#6b1f2a",
    },
    {
      id: "memoir-narrative",
      name: "Memoir & Narrative",
      badge: "Penguin Press / Norton",
      num: 7,
      accent: "#5c3d1e",
      bg: "#fffefb",
      chapterLabel: "Three",
      chapterLabelStyle: { fontFamily: "'Playfair Display', serif", fontSize: 14, fontStyle: "italic", color: "#5c3d1e", textAlign: "center" as const },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 19, fontWeight: 700, color: "#1c120a", textAlign: "center" as const, lineHeight: 1.3 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11.5, fontStyle: "italic", color: "#2e1f0f", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11, lineHeight: 1.62, color: "#1c120a", textIndent: "34px", textAlign: "justify" as const },
      dividerColor: "#c4aa88", showDivider: false, dividerWidth: "40%", dividerAlign: "center" as const,
      paragraphGap: 0, dropCapColor: "#5c3d1e",
    },
    {
      id: "study-reference",
      name: "Study & Reference",
      badge: "Crossway / Moody",
      num: 8,
      accent: "#2d5a27",
      bg: "#faf8f2",
      chapterLabel: "CHAPTER 3",
      chapterLabelStyle: { fontFamily: "'Inter', sans-serif", fontSize: 8, letterSpacing: "0.2em", color: "#2d5a27", textAlign: "left" as const, fontWeight: 600 },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 20, fontWeight: 700, color: "#111111", textAlign: "left" as const, lineHeight: 1.25 },
      sectionStyle: { fontFamily: "'Inter', sans-serif", fontSize: 11, fontWeight: 700, color: "#111111", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 10.5, lineHeight: 1.55, color: "#111111", textIndent: "26px", textAlign: "justify" as const },
      dividerColor: "#2d5a27", showDivider: true, dividerWidth: "100%", dividerAlign: "left" as const,
      paragraphGap: 0, dropCapColor: "#2d5a27", sectionRule: true,
    },
    {
      id: "charismatic-prophetic",
      name: "Charismatic & Prophetic",
      badge: "Destiny Image / River",
      num: 9,
      accent: "#4a1d8a",
      bg: "#fdfcff",
      chapterLabel: "Chapter 3",
      chapterLabelStyle: { fontFamily: "'Playfair Display', serif", fontSize: 11, fontStyle: "italic", color: "#4a1d8a", textAlign: "center" as const },
      chapterTitleStyle: { fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 700, color: "#0e0518", textAlign: "center" as const, lineHeight: 1.2 },
      sectionStyle: { fontFamily: "'Playfair Display', serif", fontSize: 14, fontWeight: 700, color: "#4a1d8a", textAlign: "center" as const },
      bodyStyle: { fontFamily: "'Playfair Display', serif", fontSize: 12.5, lineHeight: 1.82, color: "#0e0518", textAlign: "justify" as const },
      dividerColor: "#7b52b9", showDivider: true, dividerWidth: "45%", dividerAlign: "center" as const,
      paragraphGap: 14, dropCapColor: "#4a1d8a",
    },
    {
      id: "leadership-vision",
      name: "Leadership & Vision",
      badge: "Crown / FaithWords",
      num: 10,
      accent: "#c9a227",
      bg: "#ffffff",
      chapterLabel: "3",
      chapterLabelStyle: { fontFamily: "'Inter', sans-serif", fontSize: 56, fontWeight: 900, color: "#c9a227", textAlign: "left" as const, lineHeight: 1 },
      chapterTitleStyle: { fontFamily: "'Inter', sans-serif", fontSize: 22, fontWeight: 700, color: "#1a1a1a", textAlign: "left" as const, lineHeight: 1.2 },
      sectionStyle: { fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 700, color: "#1a1a1a", textAlign: "left" as const },
      bodyStyle: { fontFamily: "'Inter', sans-serif", fontSize: 11.5, lineHeight: 1.68, color: "#1a1a1a", textAlign: "left" as const },
      dividerColor: "#c9a227", showDivider: true, dividerWidth: "100%", dividerAlign: "left" as const,
      paragraphGap: 10, dropCapColor: "#c9a227", sectionRule: true,
    },
  ];

  const sampleTitle = "Walking in Authority";
  const sampleBody1 = "here is a power available to every believer that most have never fully claimed. The authority Christ purchased at Calvary was not meant to sit dormant in our theology—it was meant to be exercised daily, in every circumstance, against every opposing force.";
  const sampleBody2 = "When Jesus commissioned the disciples, He did not merely give them a task. He gave them a position—His name, His power, and His authority over every work of the enemy. That commission has never expired.";
  const sampleSection = "The Nature of Spiritual Authority";

  return (
    <div style={{ minHeight: "100vh", background: "#0f1117", padding: "40px 32px", fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.2em", color: "#4b5563", textTransform: "uppercase", marginBottom: 6 }}>Nexus Director</p>
        <h1 style={{ fontSize: 26, fontWeight: 700, color: "#f9fafb", margin: 0 }}>Book Layout Templates</h1>
        <p style={{ marginTop: 6, fontSize: 13, color: "#6b7280" }}>10 industry-standard styles — choose one before exporting your PDF</p>
      </div>

      {/* Template grid — 2 columns */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 20, maxWidth: 1100, margin: "0 auto" }}>
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            style={{
              borderRadius: 16,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.07)",
              background: "#1a1d27",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
            }}
          >
            {/* Label bar */}
            <div style={{ padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: "#f3f4f6", lineHeight: 1.2 }}>{tpl.name}</div>
                <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{tpl.badge}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, color: "#374151", background: "#111827", borderRadius: 999, padding: "2px 8px", border: "1px solid #1f2937" }}>#{tpl.num}</span>
                <div style={{ width: 20, height: 20, borderRadius: "50%", background: tpl.accent, border: "2px solid rgba(255,255,255,0.1)", flexShrink: 0 }} />
              </div>
            </div>

            {/* Simulated book page */}
            <div style={{ background: tpl.bg, padding: "20px 22px", flexGrow: 1, minHeight: 300 }}>
              {/* Chapter label */}
              <div style={{ ...tpl.chapterLabelStyle, marginBottom: 5 }}>{tpl.chapterLabel}</div>

              {/* Chapter title */}
              <div style={{ ...tpl.chapterTitleStyle, marginBottom: 12 }}>{sampleTitle}</div>

              {/* Accent rule under title (Business + Leadership) */}
              {(tpl.id === "modern-business") && (
                <div style={{ height: 2, background: tpl.accent, marginBottom: 12, width: "100%" }} />
              )}
              {(tpl.id === "leadership-vision") && (
                <div style={{ height: 1, background: "#e5e7eb", marginBottom: 12, width: "100%" }} />
              )}

              {/* Body ¶1 with drop cap */}
              <div style={{ overflow: "hidden", marginBottom: tpl.paragraphGap || 0 }}>
                <span style={{
                  float: "left",
                  fontFamily: "'Playfair Display', serif",
                  fontSize: tpl.id === "study-reference" ? 38 : 44,
                  fontWeight: 700,
                  lineHeight: 0.82,
                  marginRight: 3,
                  marginTop: 4,
                  color: tpl.dropCapColor,
                }}>T</span>
                <p style={{ ...tpl.bodyStyle, margin: 0, textIndent: 0 }}>{sampleBody1}</p>
              </div>

              {/* Body ¶2 */}
              <p style={{ ...tpl.bodyStyle, margin: 0, marginTop: tpl.paragraphGap > 0 ? tpl.paragraphGap : 2 }}>{sampleBody2}</p>

              {/* Divider */}
              {tpl.showDivider ? (
                <div style={{ marginTop: 12, marginBottom: 12, display: "flex", justifyContent: tpl.dividerAlign === "center" ? "center" : "flex-start" }}>
                  <div style={{ height: tpl.id === "modern-business" ? 2 : 0.75, background: tpl.dividerColor, width: tpl.dividerWidth }} />
                </div>
              ) : (
                <div style={{ marginTop: 14 }} />
              )}

              {/* Section heading */}
              <div style={{ ...tpl.sectionStyle, marginBottom: 6 }}>{sampleSection}</div>

              {/* Section rule (Study & Leadership) */}
              {tpl.sectionRule && (
                <div style={{ height: 1, background: tpl.accent, marginBottom: 8, width: "40%" }} />
              )}

              {/* Body ¶3 */}
              <p style={{ ...tpl.bodyStyle, margin: 0 }}>
                There is a power available to every believer that most have never fully claimed. The authority Christ purchased at Calvary was not meant to sit dormant in our theology…
              </p>
            </div>

            {/* Footer */}
            <div style={{ padding: "8px 16px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "flex-end", background: "rgba(0,0,0,0.2)" }}>
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: tpl.accent + "22", color: tpl.accent, border: `1px solid ${tpl.accent}44`, fontWeight: 600 }}>
                {tpl.id}
              </span>
            </div>
          </div>
        ))}
      </div>

      <p style={{ textAlign: "center", color: "#374151", fontSize: 11, marginTop: 32 }}>
        Click <strong style={{ color: "#6b7280" }}>Layout</strong> in the Final Review toolbar to select a template before exporting.
      </p>
    </div>
  );
}
