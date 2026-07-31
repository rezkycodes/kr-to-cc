import './styles.css';
import { createApp } from 'vue';
import App from './app/App.vue';
import router from './app/router';

createApp(App).use(router).mount('#app');
