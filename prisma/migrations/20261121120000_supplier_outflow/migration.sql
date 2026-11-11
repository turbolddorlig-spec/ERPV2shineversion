-- #122 Нийлүүлэгчийн мини гарц: өөрийн өртөг (зөвхөн нийлүүлэгч харна)
CREATE TABLE "SupplierOwnCost" (
    "shopId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "cost" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierOwnCost_pkey" PRIMARY KEY ("shopId","productId")
);
