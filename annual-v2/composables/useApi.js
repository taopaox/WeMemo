import { request } from '~/bridge'
export const useApi = () => ({
  listChatAccounts: () => request('accounts'),
  getWrappedAnnualMeta: args => request('meta', args),
  getWrappedAnnualCard: (id, args) => request('card', { ...args, id })
})
