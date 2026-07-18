const topbar = document.querySelector(".topbar");

window.addEventListener(
  "scroll",
  () => {
    const opacity = window.scrollY > 24 ? "0 18px 45px rgba(18, 41, 36, 0.08)" : "none";
    topbar.style.boxShadow = opacity;
  },
  { passive: true },
);
