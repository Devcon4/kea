<script setup>
</script>

<template>
  <h1>Form Testing Playground</h1>
  <p>Explore different forms with various accessibility and functionality issues for testing.</p>
  <div class="card-grid">
    <div class="card">
      <router-link to="/register">Register</router-link>
      <p>User registration with multiple field types.</p>
    </div>
    <div class="card">
      <router-link to="/search">Search</router-link>
      <p>Search form with server endpoint.</p>
    </div>
    <div class="card">
      <router-link to="/feedback">Feedback</router-link>
      <p>Feedback form with rating and comments.</p>
    </div>
  </div>
</template>

<style scoped>
.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 1rem;
}
.card {
  background: #fff;
  border-radius: 8px;
  padding: 1.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  text-align: center;
}
.card a {
  color: #0d3b2e;
  text-decoration: none;
  font-weight: 600;
  font-size: 1.05rem;
}
.card a:hover {
  color: #1a8a6a;
}
.card p {
  font-size: 0.9rem;
  margin-top: 0.5rem;
}
</style>
