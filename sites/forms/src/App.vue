<script setup>
</script>

<template>
  <nav>
    <router-link to="/" class="brand">Kea Forms</router-link>
    <router-link to="/register">Register</router-link>
    <router-link to="/search">Search</router-link>
    <router-link to="/feedback">Feedback</router-link>
  </nav>
  <main>
    <router-view />
  </main>
  <footer>&copy; 2026 Kea Forms. All rights reserved.</footer>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #1a2e2a;
  background: #f4faf8;
}
nav {
  background: #0d3b2e;
  padding: 1rem 2rem;
  display: flex;
  gap: 2rem;
  align-items: center;
}
nav a {
  color: #d0ebe3;
  text-decoration: none;
  font-size: 0.95rem;
}
nav a:hover {
  color: #5ec4a8;
}
nav .brand {
  font-weight: 700;
  font-size: 1.2rem;
  color: #5ec4a8;
}
main {
  max-width: 700px;
  margin: 2rem auto;
  padding: 0 1rem;
}
h1 {
  color: #0d3b2e;
  margin-bottom: 1rem;
}
p {
  line-height: 1.6;
  color: #444;
  margin-bottom: 1rem;
}
footer {
  text-align: center;
  padding: 2rem;
  color: #888;
  font-size: 0.85rem;
}
</style>
