// Turns any <div data-asciinema="<cast-url>"> into an asciinema player.
// The player lib (loaded just before this file via extra_javascript) is global.
window.addEventListener("load", () => {
  if (!window.AsciinemaPlayer) return
  document.querySelectorAll("[data-asciinema]").forEach((el) => {
    AsciinemaPlayer.create(el.getAttribute("data-asciinema"), el, {
      cols: Number.parseInt(el.getAttribute("data-cols") || "98", 10),
      rows: Number.parseInt(el.getAttribute("data-rows") || "30", 10),
      poster: "npt:0:0",
      idleTimeLimit: 1.5,
      theme: "asciinema",
    })
  })
})
