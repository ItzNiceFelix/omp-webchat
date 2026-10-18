/**
 * Bundled fonts.
 *
 * The design asks for IBM Plex Sans (UI) and JetBrains Mono (code). Both ship with the
 * bundle as woff2 through @fontsource, latin subset only, so the UI never falls back to a
 * system font and never reaches out to a font CDN.
 */
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
