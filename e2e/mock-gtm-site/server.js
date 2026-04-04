const express = require("express");
const path = require("path");
const app = express();
const PORT = 4000;

app.use(express.static(path.join(__dirname, "pages")));

// LinkedIn Sales Nav - Search
app.get("/sales-nav/search", (_, res) => res.sendFile(path.join(__dirname, "pages/sales-nav-search.html")));

// LinkedIn Sales Nav - Profile
app.get("/sales-nav/profile/:name", (req, res) => {
  res.sendFile(path.join(__dirname, "pages/sales-nav-profile.html"));
});

// Crunchbase
app.get("/crunchbase/:company", (_, res) => res.sendFile(path.join(__dirname, "pages/crunchbase.html")));

// Gmail Compose
app.get("/gmail/compose", (_, res) => res.sendFile(path.join(__dirname, "pages/gmail-compose.html")));

// Clay
app.get("/clay/tables", (_, res) => res.sendFile(path.join(__dirname, "pages/clay-tables.html")));
app.get("/clay/tables/new", (_, res) => res.sendFile(path.join(__dirname, "pages/clay-create-table.html")));
app.get("/clay/tables/:id", (_, res) => res.sendFile(path.join(__dirname, "pages/clay-table-detail.html")));

// Sensitive fields test page
app.get("/test/sensitive", (_, res) => res.sendFile(path.join(__dirname, "pages/sensitive-test.html")));

app.listen(PORT, () => console.log(`Mock GTM site on http://localhost:${PORT}`));
