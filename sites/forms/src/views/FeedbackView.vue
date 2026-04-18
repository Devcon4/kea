<script setup>
</script>

<template>
  <h1>Send Us Feedback</h1>
  <p>We appreciate your feedback. Let us know how we can improve.</p>
  <form action="/api/feedback" method="POST">
    <div class="field">
      <label for="name">Your Name</label>
      <input type="text" id="name" name="name" placeholder="Jane Doe">
    </div>

    <!-- INTENTIONAL ISSUE: input without associated label -->
    <div class="field">
      <span style="font-weight:600; font-size:0.95rem; color:#1a2e2a;">Your Email</span>
      <input type="email" id="feedback-email" name="email" placeholder="jane@example.com">
    </div>

    <div class="field">
      <label for="rating">Rating</label>
      <select id="rating" name="rating">
        <option value="">Select a rating</option>
        <option value="5">5 — Excellent</option>
        <option value="4">4 — Good</option>
        <option value="3">3 — Average</option>
        <option value="2">2 — Poor</option>
        <option value="1">1 — Terrible</option>
      </select>
    </div>

    <div class="field">
      <label for="comments">Comments</label>
      <textarea id="comments" name="comments" placeholder="Tell us what you think..."></textarea>
    </div>

    <button type="submit" class="submit-btn">Submit Feedback</button>
  </form>
</template>

<style scoped>
main {
  max-width: 500px;
}
form {
  background: #fff;
  border-radius: 8px;
  padding: 2rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
.field {
  margin-bottom: 1.25rem;
}
label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.35rem;
  color: #1a2e2a;
  font-size: 0.95rem;
}
input,
select,
textarea {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1rem;
  font-family: inherit;
}
input:focus,
select:focus,
textarea:focus {
  outline: 2px solid #1a8a6a;
  border-color: #1a8a6a;
}
textarea {
  resize: vertical;
  min-height: 120px;
}
/* INTENTIONAL ISSUE: submit button has no visible focus style */
button.submit-btn {
  background: #0d3b2e;
  color: #fff;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  margin-top: 0.5rem;
  outline: none;
}
button.submit-btn:hover {
  background: #1a8a6a;
}
button.submit-btn:focus {
  outline: none;
}
</style>
