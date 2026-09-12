/*
 * Pathayam — site behaviour.
 *
 * Two things: the theme toggle, and the envelope demo. The demo is a faithful
 * miniature of the real engine's arithmetic — assigned minus activity is
 * available, and Ready to Assign is income minus everything assigned — because
 * a demo that rounds the model off teaches the wrong thing about a product
 * whose whole claim is that the model is exact.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------- theme -- */
  var root = document.documentElement;

  function store(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }
  function read(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  var saved = read("pathayam-theme");
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);

  function resolved() {
    var set = root.getAttribute("data-theme");
    if (set) return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    var paint = function () {
      var next = resolved() === "dark" ? "light" : "dark";
      toggle.textContent = resolved() === "dark" ? "☀" : "☾";
      toggle.setAttribute("aria-label", "Switch to " + next + " theme");
      toggle.setAttribute("title", "Switch to " + next + " theme");
    };
    paint();
    toggle.addEventListener("click", function () {
      var next = resolved() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      store("pathayam-theme", next);
      paint();
    });
  }

  /* -------------------------------------------------------------- demo -- */
  var demo = document.querySelector("[data-demo]");
  if (!demo) return;

  var INCOME = 145000;

  /* A month already part-budgeted, which is what a household actually opens to.
     Targets sum to exactly the income, so "fund every target" lands Ready to
     Assign on zero — and one envelope starts overspent, because the red state is
     the one worth showing rather than hiding. Whole rupees here; the real engine
     works in integer paise, the same idea one decimal place further down. */
  var SEED = [
    { group: "Bills",               name: "Rent",             target: 45000, activity: 45000, assigned: 45000 },
    { group: "Bills",               name: "Electricity",      target: 2400,  activity: 2180,  assigned: 2400 },
    { group: "Bills",               name: "Internet",         target: 1200,  activity: 1200,  assigned: 1200 },
    { group: "Bills",               name: "Maintenance",      target: 3300,  activity: 3300,  assigned: 3300 },
    { group: "Flexible",            name: "Groceries",        target: 14000, activity: 12460, assigned: 14000 },
    { group: "Flexible",            name: "Eating out",       target: 6000,  activity: 5320,  assigned: 4000 },
    { group: "Flexible",            name: "Transport",        target: 3500,  activity: 2890,  assigned: 3500 },
    { group: "Credit card payments", name: "Swiggy HDFC",     target: 11600, activity: 0,     assigned: 11600 },
    { group: "Goals",               name: "Emergency fund",   target: 58000, activity: 0,     assigned: 0 }
  ];

  var rows = SEED.map(function (r) {
    return { group: r.group, name: r.name, target: r.target, activity: r.activity, assigned: r.assigned };
  });

  /* The Indian grouping the app uses everywhere: last three digits, then pairs. */
  function groupIndian(n) {
    var s = String(Math.abs(n));
    if (s.length <= 3) return s;
    var head = s.slice(0, -3);
    var tail = s.slice(-3);
    return head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
  }
  function rupees(n) {
    return (n < 0 ? "-₹" : "₹") + groupIndian(n);
  }

  var elRta = demo.querySelector("[data-rta]");
  var elBody = demo.querySelector("[data-rows]");
  var elMsg = demo.querySelector("[data-msg]");

  function assignedTotal() {
    return rows.reduce(function (a, r) { return a + r.assigned; }, 0);
  }

  function render() {
    var rta = INCOME - assignedTotal();

    elRta.textContent = rupees(rta);
    elRta.classList.toggle("is-zero", rta === 0);
    elRta.classList.toggle("is-neg", rta < 0);

    var lastGroup = null;
    var html = "";
    rows.forEach(function (r, i) {
      if (r.group !== lastGroup) {
        html += '<div class="row__group">' + r.group + "</div>";
        lastGroup = r.group;
      }
      var available = r.assigned - r.activity;
      var cls = available < 0 ? "over" : available === 0 ? "zero" : "ok";
      html +=
        '<div class="row">' +
          '<div class="row__name">' + r.name + "</div>" +
          '<div><label class="sr-only" for="a' + i + '">Assign to ' + r.name + "</label>" +
            '<input class="assign-input" id="a' + i + '" data-i="' + i + '" type="text" ' +
                   'inputmode="numeric" value="' + (r.assigned ? groupIndian(r.assigned) : "") +
                   '" placeholder="0"></div>' +
          '<div class="num" style="color:var(--muted)">' + (r.activity ? rupees(-r.activity) : "—") + "</div>" +
          '<div class="num avail ' + cls + '">' + rupees(available) + "</div>" +
        "</div>";
    });
    elBody.innerHTML = html;

    var overspent = rows.filter(function (r) { return r.assigned - r.activity < 0; });
    if (rta < 0) {
      say("You have assigned more than arrived. Ready to Assign is never allowed to stay negative — take some back.");
    } else if (overspent.length) {
      say(overspent.length + (overspent.length === 1 ? " envelope is" : " envelopes are") +
          " overspent. Cover it from another envelope, or let the rollover reduce next month.");
    } else if (rta === 0) {
      say("Every rupee has a job. That is the whole idea.");
    } else {
      say(rupees(rta) + " still has no job.");
    }
  }

  function say(text) { elMsg.textContent = text; }

  elBody.addEventListener("input", function (e) {
    var input = e.target.closest(".assign-input");
    if (!input) return;
    var i = Number(input.getAttribute("data-i"));
    var value = parseInt(input.value.replace(/[^0-9]/g, ""), 10);
    rows[i].assigned = isNaN(value) ? 0 : value;

    /* Re-rendering on every keystroke would steal the caret, so only the
       derived figures are repainted while the field has focus. */
    var rta = INCOME - assignedTotal();
    elRta.textContent = rupees(rta);
    elRta.classList.toggle("is-zero", rta === 0);
    elRta.classList.toggle("is-neg", rta < 0);

    var row = input.closest(".row");
    var cell = row.querySelector(".avail");
    var available = rows[i].assigned - rows[i].activity;
    cell.textContent = rupees(available);
    cell.className = "num avail " + (available < 0 ? "over" : available === 0 ? "zero" : "ok");
  });

  elBody.addEventListener("focusout", function () { window.setTimeout(render, 0); });

  demo.querySelectorAll("[data-act]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var act = btn.getAttribute("data-act");

      if (act === "targets") {
        /* R9: Ready to Assign is spent down the budget in order, so what you
           budgeted for first is funded first and the shortfall lands last. */
        var left = INCOME;
        rows.forEach(function (r) {
          var give = Math.min(r.target, left);
          r.assigned = give;
          left -= give;
        });
      } else if (act === "charge") {
        var eat = rows.filter(function (r) { return r.name === "Eating out"; })[0];
        eat.activity += 2400;
      } else if (act === "reset") {
        rows.forEach(function (r, i) { r.assigned = SEED[i].assigned; r.activity = SEED[i].activity; });
      }
      render();
    });
  });

  render();
})();
