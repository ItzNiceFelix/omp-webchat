/**
 * Bundled fonts.
 *
 * IBM Plex Sans carries body and UI text; JetBrains Mono carries code, tool names,
 * and every numeric readout. Geist was dropped: it is one of the most overused
 * interface faces, and the pairing this design commits to is Plex + JetBrains.
 *
 * Only the weights actually used are imported. Each extra weight is a separate
 * file on the wire, which matters on the APK WebView.
 */
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-700.css";
