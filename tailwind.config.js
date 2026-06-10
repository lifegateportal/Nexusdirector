/** @type {import('tailwindcss').Config} */
const config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        shell: {
          950: "#02040d",
          900: "#060c1a",
          800: "#0b1528"
        },
        accent: {
          300: "#67e8f9",
          400: "#22d3ee",
          500: "#06b6d4",
          600: "#0891b2"
        }
      },
      boxShadow: {
        panel: "0 8px 32px rgba(0, 0, 0, 0.60)",
        glow: "0 0 28px rgba(6, 182, 212, 0.55)",
        "glow-sm": "0 0 14px rgba(6, 182, 212, 0.40)",
        "glow-lg": "0 0 50px rgba(6, 182, 212, 0.65)",
        "glow-emerald": "0 0 12px rgba(52, 211, 153, 0.80)",
        "glow-cyan": "0 0 16px rgba(6, 182, 212, 1.0)",
        "glow-violet": "0 0 14px rgba(139, 92, 246, 0.80)"
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        },
        "scan-line": {
          "0%, 100%": { opacity: "0.3" },
          "50%": { opacity: "1" }
        }
      },
      animation: {
        "fade-up": "fade-up 0.25s ease-out both",
        "scan-line": "scan-line 2s ease-in-out infinite"
      }
    }
  },
  plugins: []
};

export default config;
