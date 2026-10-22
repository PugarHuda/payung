// Lets Android show Payung's browser alerts (it only allows notifications through a service
// worker) and brings the app forward when one is tapped. No caching: numbers must be live.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((tabs) => (tabs[0] ? tabs[0].focus() : self.clients.openWindow(self.registration.scope))))
})
