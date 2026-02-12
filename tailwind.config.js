/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./*.{ts,tsx}",
        "./components/**/*.{ts,tsx}",
        "./services/**/*.{ts,tsx}",
    ],
    darkMode: "class",
    theme: {
        extend: {
            colors: {
                "primary": "#e6cf19",
                "background-light": "#f8f8f6",
                "background-dark": "#211f11",
                "border-gold": "#e2e2d5",
                "average-blue": "#1e40af",
                "growth-green": "#059669",
                "below-avg-gold": "#d97706",
                "downturn-red": "#dc2626",
            },
            fontFamily: {
                "display": ["Lexend", "sans-serif"],
            },
        },
    },
    plugins: [],
};
