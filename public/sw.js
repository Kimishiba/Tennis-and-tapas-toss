// Service Worker for Tennis Toss Notifications
self.addEventListener('push', event => {
  let data = { title: 'TOSS APP', body: 'New pairing alerts published!' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data = { title: 'TOSS APP', body: event.data.text() };
    }
  }

  const options = {
    body: data.body,
    icon: self.location.origin + '/images/tennis_facility_main.png', // default tennis thumbnail
    badge: self.location.origin + '/images/tennis_facility_main.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  const targetUrl = event.notification.data.url;
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus if an app window is already open
      for (const client of clientList) {
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
