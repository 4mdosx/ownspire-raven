/**
 * pm2 启动配置（与 creative-atlas 同一形状）。
 *
 * 端口分配：容器内 5800 / 宿主 5801（atlas 占 5600/5601，navi 占 5500/5501）。
 */
module.exports = {
  apps: [
    {
      name: 'ownspire-raven',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 5800',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: '5800',
      },
    },
  ],
}
