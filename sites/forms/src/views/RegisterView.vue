<script setup>
</script>

<template>
  <h1>Create an Account</h1>
  <form action="/api/register" method="POST">
    <div class="field">
      <label for="fullname">Full Name</label>
      <input type="text" id="fullname" name="fullname" required aria-required="true" placeholder="Jane Doe">
    </div>

    <!-- INTENTIONAL ISSUE: input without associated label (no <label> element) -->
    <div class="field">
      <span style="font-weight:600; font-size:0.95rem; color:#1a2e2a;">Username</span>
      <input type="text" id="username" name="username" required aria-required="true" placeholder="janedoe42">
    </div>

    <!-- INTENTIONAL ISSUE: email input without proper type (uses type="text" instead of type="email") -->
    <div class="field">
      <label for="email">Email Address</label>
      <input type="text" id="email" name="email" required aria-required="true" placeholder="jane@example.com">
      <p class="hint">We'll never share your email with anyone.</p>
    </div>

    <!-- INTENTIONAL ISSUE: required field without aria-required -->
    <div class="field">
      <label for="phone">Phone Number</label>
      <input type="tel" id="phone" name="phone" required placeholder="555-0123">
    </div>

    <!-- INTENTIONAL ISSUE: password field with no autocomplete attribute -->
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" required aria-required="true" placeholder="••••••••">
    </div>

    <div class="field">
      <label for="role">Role</label>
      <select id="role" name="role">
        <option value="">Select a role</option>
        <option value="tester">Tester</option>
        <option value="developer">Developer</option>
        <option value="manager">Manager</option>
      </select>
    </div>

    <button type="submit">Register</button>
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
select {
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 1rem;
}
input:focus,
select:focus {
  outline: 2px solid #1a8a6a;
  border-color: #1a8a6a;
}
button {
  background: #0d3b2e;
  color: #fff;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  margin-top: 0.5rem;
}
button:hover {
  background: #1a8a6a;
}
/* INTENTIONAL ISSUE: poor contrast — light gray on white */
.hint {
  color: #ccc;
  font-size: 0.8rem;
  margin-top: 0.2rem;
}
</style>
