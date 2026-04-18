const express = require("express");
const expressLayouts = require("express-ejs-layouts");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Product data — some entries have INTENTIONAL issues for chaos testing
const products = [
  {
    id: 1,
    name: "Chaos Toolkit Pro",
    price: 99.99,
    image: "https://picsum.photos/seed/product1/400/200",
    detailImage: "https://picsum.photos/seed/product1/700/300",
    description:
      "The Chaos Toolkit Pro is a comprehensive chaos engineering solution that helps you proactively find weaknesses in your systems. Inject failures, monitor responses, and build confidence in your infrastructure.",
    features:
      "Features include: automated fault injection, real-time monitoring dashboard, customizable experiment templates, and integration with all major cloud providers.",
  },
  {
    id: 2,
    name: "Load Tester Deluxe",
    price: 149.99,
    image: "https://picsum.photos/seed/product2/400/200",
    detailImage: "https://picsum.photos/seed/product2/700/300",
    description:
      "The Load Tester Deluxe generates realistic traffic patterns to stress-test your applications under load. Simulate thousands of concurrent users and identify performance bottlenecks before they affect real users.",
    features:
      "Includes: distributed load generation, real-time metrics, customizable scenarios, latency percentile tracking, and detailed HTML reports.",
  },
  {
    id: 3,
    name: "Accessibility Scanner",
    price: 79.99,
    // INTENTIONAL ISSUE: broken image src — file does not exist
    image: "/images/product-3-nonexistent.jpg",
    detailImage: "/images/product-3-nonexistent.jpg",
    description:
      "The Accessibility Scanner automatically checks your website for WCAG 2.1 compliance. It identifies missing alt text, poor color contrast, missing form labels, and keyboard navigation issues.",
    features:
      "Supports: WCAG 2.1 Level A and AA, Section 508, ARIA validation, color contrast analysis, and screen reader compatibility checks.",
  },
  {
    id: 4,
    name: "Browser Automator",
    price: 199.99,
    // INTENTIONAL ISSUE: mixed content — http:// URL on an https page
    image: "http://placekitten.com/400/200",
    detailImage: "http://placekitten.com/700/300",
    description:
      "Browser Automator lets you script and replay browser interactions for end-to-end testing. Record user flows, parameterize test data, and run them across multiple browsers simultaneously.",
    features:
      "Built-in support for: Chromium, Firefox, WebKit, visual regression testing, network interception, and parallel execution across CI environments.",
  },
];

// View engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Routes

app.get("/", (_req, res) => {
  res.render("index", { title: "Our Products", products });
});

app.get("/product/:id", (req, res) => {
  const product = products.find((p) => p.id === Number(req.params.id));
  if (!product) {
    return res.status(404).render("404", { title: "Page Not Found" });
  }
  res.render("product", { title: product.name, product });
});

app.get("/cart", (_req, res) => {
  res.render("cart", { title: "Cart" });
});

app.get("/checkout", (_req, res) => {
  res.render("checkout", { title: "Checkout" });
});

// INTENTIONAL ISSUE: /admin route deliberately returns 404
app.get("/admin", (_req, res) => {
  res.status(404).render("404", { title: "Page Not Found" });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).render("404", { title: "Page Not Found" });
});

app.listen(PORT, () => {
  console.log(`Kea Shop listening on http://localhost:${PORT}`);
});
