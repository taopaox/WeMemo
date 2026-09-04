import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/style.css'
import './assets/host.css'
const app = createApp(App)
app.use(createPinia())
const components = import.meta.glob('./components/**/*.vue', { eager: true, import: 'default' })
for (const [path, component] of Object.entries(components)) app.component(path.split('/').pop().replace('.vue', ''), component)
app.mount('#app')
