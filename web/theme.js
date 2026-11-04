// Light or dark: the visitor's choice, else what their system prefers. A plain script loaded before the page is drawn, so that it
// never flashes in the wrong theme.
(() => {
  const STORE = "tissway.theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  const saved = () => {
    try {
      return localStorage.getItem(STORE);
    } catch {
      return null;
    }
  };
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    const toggle = document.getElementById("theme-toggle");
    if (toggle) toggle.checked = theme === "dark";
  };
  const wanted = () => saved() || (system.matches ? "dark" : "light");

  apply(wanted());
  system.addEventListener("change", () => apply(wanted())); // followed until a choice is made
  addEventListener("DOMContentLoaded", () => {
    apply(wanted());
    document.getElementById("theme-toggle").addEventListener("change", (e) => {
      const theme = e.target.checked ? "dark" : "light";
      try {
        localStorage.setItem(STORE, theme);
      } catch { /* storage unavailable: until the page is closed */ }
      apply(theme);
    });
  });
})();
