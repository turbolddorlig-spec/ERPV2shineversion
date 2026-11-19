# Хуучин ERP → шинэ ERP өгөгдөл шилжүүлэх заавар (компани бүрт)

> 2026-11-20-нд 1-р компанид (zahialgahurgelt.mn) хийсэн алхмаар бичив. Дараагийн компанид яг ингэж хийнэ.
> Хуучин систем огт өөрчлөгдөхгүй — зөвхөн хуулбар авна. Хуулбар файлд үйлчлүүлэгчийн мэдээлэл байгаа тул
> **Claude-д, GitHub-д илгээхгүй**, зөвхөн хоёр серверийн хооронд зөөнө. Дууссаны дараа хоёр серверээс устгана.

## Юу шилжих вэ (эзний шийдвэр)
- ОРНО: ажилчид + эрх (хуучин нууц үгээрээ нэвтэрнэ), бараа + зураг (үлдэгдэл 0 — агуулахаа тоолж оруулна), агуулах, ангилал, пэйж, хар жагсаалт, нээлттэй өр, бүх захиалга.
- ОРОХГҮЙ: нийлүүлэгч (шинээр үүсгэнэ), агуулахын үлдэгдэл, хүргэлтэд яваа сүүлийн өдрүүдэд ҮҮССЭН захиалга (хуучин ERP-д дуусгана).
- Алгасах өдрүүдийг компани бүрт тохируулна: `SKIP_FROM=2026-11-18 SKIP_TO=2026-11-20 ./legacy-migrate.sh …`

## A. Хуучин сервер дээр
1. Нэвтрэх: `ssh cloudmn@ХУУЧИН_IP`
2. Ажиллаж буй програмууд: `sudo docker ps --format 'table {{.Names}}\t{{.Ports}}'`
   → database контейнер (жишээ `erp_postgres`), вэб контейнер (жишээ `aa48be45b7db_erp_web`).
3. Database-ийн нэр: `sudo docker exec erp_postgres psql -U app -d postgres -c '\l'`
   → бодит өгөгдөлтэйг нь олно (1-р компанид `c2_db`, эзэн нь `c2_user`).
4. Зөв эсэхийг тоолж шалгах:
   `sudo docker exec erp_postgres psql -U c2_user -d c2_db -c 'select (select count(*) from "Order"), (select count(*) from "Product"), (select count(*) from "User"), (select max("createdAt") from "Order")'`
5. Database-ийн хуулбар:
   `mkdir -p ~/migration && sudo docker exec erp_postgres pg_dump -U c2_user -d c2_db --no-owner | gzip > ~/migration/old-erp-db.sql.gz && ls -lh ~/migration/`
6. Барааны зураг (эхлээд байрлалыг шалгах: `sudo docker exec ВЭБ_КОНТЕЙНЕР ls /app/public/uploads/products | wc -l`):
   `sudo docker cp ВЭБ_КОНТЕЙНЕР:/app/public/uploads/products ~/migration/products && sudo tar czf ~/migration/old-erp-images.tar.gz -C ~/migration products && sudo rm -r ~/migration/products && sudo chown cloudmn:cloudmn ~/migration/old-erp-images.tar.gz && ls -lh ~/migration/`
7. Шинэ сервер рүү илгээх (шинэ серверийн нууц үгийг 2 удаа асууна):
   `ssh cloudmn@ШИНЭ_IP 'mkdir -p ~/migration && chmod 700 ~/migration' && scp ~/migration/old-erp-db.sql.gz ~/migration/old-erp-images.tar.gz cloudmn@ШИНЭ_IP:~/migration/`

## B. Шинэ сервер дээр
1. `cd ~/erp-v2 && ./update.sh`
2. `./legacy-migrate.sh analyze` — зөвхөн тоолно (хуулбарыг сэргээхэд 5–15 минут, дэлгэц чимээгүй — хүлээнэ).
   Тайлангийн тоонуудыг (захиалга төлөвөөр, бараа, ажилчид) шалгана.
3. Туршилт (заавал биш — 1-р компанид хийсэн, програм баталгаажсан): `./legacy-migrate.sh trial` → `http://ШИНЭ_IP:3001`
4. Жинхэнэ: `./legacy-migrate.sh real` («ШИЛЖҮҮЛ» гэж бичнэ; өмнө нь автомат backup; апп хэдэн минут зогсоно)
5. Шалгах: Супер админаар нэвтэрч бараа, ажилчид, захиалгын түүхийг харна; агуулахаа тоолж үлдэгдэл оруулна.
6. Цэвэрлэх: шинэ сервер `./legacy-migrate.sh cleanup`; хуучин сервер `rm -r ~/migration`.

## Анхаарах
- Нээлттэй (дуусаагүй) хуучин захиалга «Шинэ»/«Төлбөр хүлээж буй» болж орж, бараа нөөцөлнө. Хүсвэл `--open cancel` (legacy-migrate.sh доторх run_migrate-д) — эзэнтэй тохирно.
- Ажилчид хуучин нууц үгээрээ нэвтэрнэ; эхний нэвтрэлтэд шинэ аргаар хадгалагдана.
- Буцаах: `real`-ийн төгсгөлд гарах `./restore.sh backups/…` тушаал.
