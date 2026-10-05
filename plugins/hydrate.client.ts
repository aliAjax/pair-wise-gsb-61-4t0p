import { useCertificationStore } from '~/stores/certification';

// 所有页面共享同一份本地持久化的项目与共享引用账
export default defineNuxtPlugin(() => {
  const store = useCertificationStore();
  store.hydrate();
});
