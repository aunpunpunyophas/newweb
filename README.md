# Realtime Food Order + Admin

## Run
1. ติดตั้ง Node.js (แนะนำเวอร์ชัน 18+)
2. เปิดเทอร์มินัลที่โฟลเดอร์โปรเจกต์
3. รัน:
   - `npm install`
   - `npm start`
4. เปิดใช้งาน:
   - หน้าลูกค้า: `http://localhost:3000/`
   - หน้าแอดมิน: `http://localhost:3000/admin` หรือ `http://localhost:3000/admin.html`

## Admin Login
- ค่าเริ่มต้น:
  - username: `admin`
  - password: `admin123`

สามารถเปลี่ยนได้ด้วย environment variable:
- `ADMIN_USER`
- `ADMIN_PASS`

ตัวอย่าง PowerShell:
```powershell
$env:ADMIN_USER="myadmin"
$env:ADMIN_PASS="mypassword"
npm start
```

## Use on Phone + Computer
1. ให้มือถือและคอมอยู่ Wi-Fi เดียวกัน
2. หาค่า IP ของเครื่องคอม (เช่น `192.168.1.10`)
3. บนมือถือเปิด:
   - หน้าลูกค้า: `http://192.168.1.10:3000/`
   - หน้าแอดมิน: `http://192.168.1.10:3000/admin`

ถ้าเข้าไม่ได้ ให้เช็กไฟร์วอลล์ของเครื่องคอมว่าอนุญาตพอร์ต `3000`

## Database
- ใช้ SQLite file: `orders.db`
- ตารางหลัก:
  - `admins`
  - `orders`
  - `order_items`
  <!-- // กฟไกฟฟไกฟไกฟไกฟไกไฟก -->
