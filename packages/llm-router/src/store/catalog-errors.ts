/**
 * 目录写操作的领域错误（M3·T3.4）。
 *
 * 路由层只认这些类型，`route.ts` 因此可以退化成一层薄映射（同 M2·T2.3 的形状）。
 */

/** 触碰了唯一约束（provider 的 name / model 的 (alias, providerId)）。路由层映射成 409。 */
export class CatalogConflictError extends Error {
  readonly name = 'CatalogConflictError';
}

/**
 * 引用了不存在的行（provider.credentialId / model.providerId）。
 *
 * 路由层映射成 **VALIDATION_ERROR 400** 而不是 404：404 说的是「你请求的这个
 * 资源不存在」，而这里请求的资源是要创建的 provider/model，不存在的是它 body 里
 * 指着的另一个 id——那是入参问题。
 */
export class CatalogReferenceError extends Error {
  readonly name = 'CatalogReferenceError';
  constructor(
    public readonly field: string,
    public readonly referencedId: string
  ) {
    super(`${field} ${referencedId} does not exist`);
  }
}
