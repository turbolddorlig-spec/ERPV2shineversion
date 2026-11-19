-- #182 Хуучин ERP-ийн бүтэцтэй ХУУРАМЧ өгөгдөл (шилжүүлэх програмын тест). Бодит өгөгдөл биш.
INSERT INTO "User"(id, phone, "passwordHash", name, "displayName", role, "isActive", "updatedAt") VALUES
 ('u-sa','91335599','$2a$10$abcdefghijklmnopqrstuuJ0Kq7pV3c7xXq8w6aT2B1qgS7nZ1yHe','Эзэн',NULL,'SUPER_ADMIN',true,now()),
 ('u-op','88110001','$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BWX4Z1Z1.z0rQm3/aCDDj1Dtf.6.','Оператор Сараа',NULL,'OPERATOR',true,now()),
 ('u-drv','88110002','$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BWX4Z1Z1.z0rQm3/aCDDj1Dtf.6.','Жолооч Бат','Бат жолооч','DRIVER',true,now()),
 ('u-wh','88110003','$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BWX4Z1Z1.z0rQm3/aCDDj1Dtf.6.','Агуулахын туслах',NULL,'WAREHOUSE_STAFF',true,now()),
 ('u-pr','88110004','$2a$10$7EqJtq98hPqEX7fNZaFWoOhi5BWX4Z1Z1.z0rQm3/aCDDj1Dtf.6.','Худалдан авагч',NULL,'PROCUREMENT_OFFICER',true,now()),
 ('u-ext','88110005','x','Гадны хүргэлт',NULL,'EXTERNAL_DELIVERY',true,now()),
 ('u-sup','88110006','x','Нийлүүлэгч дэлгүүр',NULL,'SUPPLIER',true,now()),
 ('u-bad','123','x','Буруу утас',NULL,'OPERATOR',true,now()),
 ('u-old','88110007','x','Гарсан ажилтан',NULL,'OPERATOR',false,now());
INSERT INTO product_categories(name, sort_order) VALUES ('Гэр ахуй',1),('Хувцас',2);
INSERT INTO "Warehouse"(id, name, "isPrimary", "isActive", "updatedAt") VALUES ('w1','Төв агуулах',true,true,now()),('w2','Салбар',false,true,now());
INSERT INTO "Product"(id, code, name, category, size, color, price, stock, image, active, "colorVariants", "updatedAt") VALUES
 (1,'1001','Шилэн аяга 6ш','Гэр ахуй',NULL,NULL,25000,40,'/uploads/products/a1.jpg',true,NULL,now()),
 (2,'1002','Цамц','Хувцас','L',NULL,45000,10,NULL,true,'[{"name":"Хар","quantity":3},{"name":"Цагаан","quantity":7}]',now()),
 (3,'1003','Хуучин бараа','Гэр ахуй',NULL,'Улаан',0,0,NULL,false,NULL,now()),
 (4,'bad code','Буруу код','Гэр ахуй',NULL,NULL,1000,0,NULL,true,NULL,now());
INSERT INTO "ProductImage"(id, "productId", "imageUrl", "displayOrder", "isMain", "updatedAt") VALUES
 ('i1',1,'/uploads/products/a1.jpg',0,true,now()),('i2',1,'https://old.example/uploads/products/a2.png?x=1',1,false,now()),('i3',2,'/uploads/products/missing.jpg',0,true,now());
INSERT INTO product_season_assignments(product_id, season) VALUES (2,'Өвөл');
INSERT INTO "FacebookPage"(id, "pageId", "pageName", "displayName", "accessToken", "updatedAt") VALUES ('fp1','111','Гэр Шоп','Гэр Шоп',' tok',now());
-- Захиалга: хүргэсэн, цуцалсан, жолооч цуцалсан, хүлээгдэж буй, мөнгө орсон, шинэ, 11/18-нд үүссэн (алгасна), устгасан, буруу утас, үл мэдэгдэх бараа
INSERT INTO "Order"(id, "orderNumber", "customerPhone", "extraPhone", address, district, province, opp, "shopSource", status, prepaid, "orderTotal", driver, products, history, "createdAt", "updatedAt", "deliveryPaymentMethod", "isPaidToDriver", "deletedAt", "discountAmount") VALUES
 (1,'00012001','99112233','99112233','Баянзүрх 13-р хороо 45-р байр','Баянзүрх','Улаанбаатар','Оператор Сараа','Гэр Шоп','DELIVERED',false,55000,'u-drv','[{"productId":1,"productName":"Шилэн аяга 6ш","quantity":2,"price":25000}]','[{"timestamp":"2026-10-01T05:00:00Z","action":"CREATED","user":"Оператор Сараа","note":""},{"timestamp":"2026-10-01T09:30:00Z","action":"DELIVERED","user":"Бат жолооч","note":""}]','2026-10-01T04:00:00Z','2026-10-02T04:00:00Z','BANK',true,NULL,0),
 (2,'00012002','+976 9911 2234',NULL,'Хан-Уул','Хан-Уул','Улаанбаатар','Байхгүй опп','Гэр Шоп','CANCELLED',false,45000,NULL,'[{"productId":2,"quantity":1,"price":45000}]','[{"timestamp":"2026-10-03T05:00:00Z","action":"CANCELLED","user":"Оператор Сараа","note":"Үйлчлүүлэгч болиулсан"}]','2026-10-03T04:00:00Z','2026-10-03T06:00:00Z',NULL,true,NULL,0),
 (3,'00012003','99112235',NULL,'Сүхбаатар',NULL,'Улаанбаатар','Оператор Сараа','Хувцас Шоп','CANCELLED_BY_DRIVER',false,45000,'u-drv','[{"productId":2,"quantity":1,"price":45000}]','[]','2026-10-04T04:00:00Z','2026-10-04T08:00:00Z',NULL,true,NULL,0),
 (4,'00012004','99112236',NULL,'Дархан',NULL,'Дархан-Уул','Оператор Сараа','Гэр Шоп','PENDING',true,50000,NULL,'[{"productId":1,"quantity":2,"price":25000}]','[]','2026-11-10T04:00:00Z','2026-11-10T04:00:00Z',NULL,true,NULL,0),
 (5,'00012005','99112237',NULL,'Эрдэнэт',NULL,'Орхон','Оператор Сараа','Гэр Шоп','PAYMENT_RECEIVED',true,25000,NULL,'[{"productId":1,"quantity":1,"price":25000}]','[]','2026-11-15T04:00:00Z','2026-11-15T04:00:00Z',NULL,true,NULL,0),
 (6,'00012006','99112238',NULL,'Чингэлтэй',NULL,'Улаанбаатар','Оператор Сараа','Гэр Шоп','NEW',false,30000,NULL,'[{"productId":1,"quantity":1,"price":25000}]','[]','2026-11-16T04:00:00Z','2026-11-16T04:00:00Z',NULL,true,NULL,0),
 (7,'00012007','99112239',NULL,'Баянгол',NULL,'Улаанбаатар','Оператор Сараа','Гэр Шоп','OUT_FOR_DELIVERY',false,25000,'u-drv','[{"productId":1,"quantity":1,"price":25000}]','[]','2026-11-18T02:00:00Z','2026-11-18T04:00:00Z',NULL,true,NULL,0),
 (8,'00012008','99112240',NULL,'Баянгол',NULL,'Улаанбаатар','Оператор Сараа','Гэр Шоп','DELIVERED',false,25000,'u-drv','[{"productId":1,"quantity":1,"price":25000}]','[]','2026-09-01T04:00:00Z','2026-09-01T04:00:00Z',NULL,true,'2026-09-02T00:00:00Z',0),
 (9,'00012009','12345',NULL,'Баянгол',NULL,'Улаанбаатар','Оператор Сараа','Гэр Шоп','DELIVERED',false,25000,'u-drv','[]','[]','2026-09-05T04:00:00Z','2026-09-05T04:00:00Z',NULL,true,NULL,0),
 (10,'00012010','99112241',NULL,'Баянгол',NULL,'Улаанбаатар','Оператор Сараа','Гэр Шоп','DELIVERED',false,20000,'u-drv','[{"productId":999,"productName":"Устсан бараа А","quantity":1,"price":10000},{"productName":"Устсан бараа Б","quantity":1,"price":15000}]','[]','2026-09-06T04:00:00Z','2026-09-06T04:00:00Z','CASH',false,NULL,5000),
 (11,'00012011','99112242',NULL,'Баянгол',NULL,'Улаанбаатар','Оператор Сараа','Гэр Шоп','DELIVERED',false,25000,'u-drv','[{"productId":1,"quantity":1,"price":25000}]','[]','2026-11-20T15:59:00Z','2026-11-20T16:00:00Z',NULL,true,NULL,0);
INSERT INTO blacklisted_phones(phone, reason, reported_by, order_number, is_active) VALUES ('99000001','Мөнгө өгдөггүй','Оператор Сараа','00012001',true),('bad','x',NULL,NULL,true);
INSERT INTO "UnpaidDebt"(id, "orderId", "driverId", "orderNumber", "customerPhone", amount, "isPaid") VALUES ('d1',10,'u-drv','00012010','99112241',20000,false),('d2',1,'u-drv','00012001','99112233',5000,true);
INSERT INTO "DriverDebtLedger"(id, "driverId", "driverName", "debtType", description, amount, status, "createdBy") VALUES ('c1','u-drv','Жолооч Бат','ACCOUNTING_MISMATCH','Тооцоо дутуу',12000,'PENDING','Нягтлан'),('c2','u-drv','Жолооч Бат','OTHER','Хаагдсан',1000,'RESOLVED','Нягтлан');
INSERT INTO "StaffDebt"(id, "userId", "userName", description, "totalAmount", "remainingAmount", "isActive", "updatedAt") VALUES ('s1','u-op','Оператор Сараа','Урьдчилгаа',100000,60000,true,now());
