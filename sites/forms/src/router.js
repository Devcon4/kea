import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import RegisterView from "./views/RegisterView.vue";
import SearchView from "./views/SearchView.vue";
import FeedbackView from "./views/FeedbackView.vue";

const routes = [
  { path: "/", component: HomeView },
  { path: "/register", component: RegisterView },
  { path: "/search", component: SearchView },
  { path: "/feedback", component: FeedbackView },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
