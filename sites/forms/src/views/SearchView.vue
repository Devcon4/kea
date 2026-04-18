<script setup>
</script>

<template>
  <h1>Search</h1>
  <p>Search our knowledge base for articles and documentation.</p>
  <!-- INTENTIONAL ISSUE: form action points to a non-existent endpoint -->
  <div class="search-box">
    <form action="/api/search" method="GET">
      <div class="search-row">
        <label for="q" class="sr-only">Search query</label>
        <input type="search" id="q" name="q" placeholder="Search articles..." aria-label="Search articles">
        <button type="submit">Search</button>
      </div>
    </form>
    <div class="results">
      <p>Enter a search term and press Search to find results.</p>
    </div>
  </div>
</template>

<style scoped>
main {
  max-width: 600px;
}
.search-box {
  background: #fff;
  border-radius: 8px;
  padding: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
.search-row {
  display: flex;
  gap: 0.5rem;
}
.search-row input {
  flex: 1;
  padding: 0.75rem 1rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1rem;
}
.search-row input:focus {
  outline: 2px solid #1a8a6a;
  border-color: #1a8a6a;
}
.search-row button {
  background: #0d3b2e;
  color: #fff;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  white-space: nowrap;
}
.search-row button:hover {
  background: #1a8a6a;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
.results {
  margin-top: 1.5rem;
  padding: 1rem;
  background: #eef8f4;
  border-radius: 4px;
  color: #555;
}
</style>
