// Tên của cache để lưu trữ tài nguyên ứng dụng
const CACHE_NAME = 'tro-ly-nnn-cache-v1';

// Danh sách các tệp cần được cache lại để ứng dụng có thể hoạt động offline
const urlsToCache = [
  '/', // Trang gốc
  'index.html' // Tệp HTML chính
  // Nếu bạn có các tệp CSS, JS, hoặc hình ảnh riêng, hãy thêm chúng vào đây.
  // Ví dụ: '/style.css', '/app.js'
];

// Sự kiện 'install': Được kích hoạt khi service worker được cài đặt lần đầu.
// Nhiệm vụ: Mở cache và thêm các tệp trong `urlsToCache` vào đó.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Cache đã được mở');
        return cache.addAll(urlsToCache);
      })
  );
});

// Sự kiện 'fetch': Được kích hoạt mỗi khi ứng dụng yêu cầu một tài nguyên (ví dụ: tải trang, hình ảnh).
// Nhiệm vụ: Kiểm tra xem tài nguyên có trong cache không.
// - Nếu có: Trả về từ cache (hoạt động offline).
// - Nếu không: Lấy từ mạng internet.
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Nếu tìm thấy trong cache, trả về phản hồi từ cache
        if (response) {
          return response;
        }
        // Nếu không, thực hiện yêu cầu mạng như bình thường
        return fetch(event.request);
      }
    )
  );
});

// Sự kiện 'activate': Được kích hoạt khi service worker mới được kích hoạt.
// Nhiệm vụ: Dọn dẹp các cache cũ không còn được sử dụng.
self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME]; // Chỉ giữ lại cache có tên này
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            // Nếu cache không nằm trong danh sách cho phép, hãy xóa nó
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
