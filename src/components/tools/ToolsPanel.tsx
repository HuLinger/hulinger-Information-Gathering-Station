'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Card, Tag } from 'antd';
import { ArrowRightOutlined, FileSyncOutlined } from '@ant-design/icons';
import styles from './ConversionWorkbench.module.css';

export default function ToolsPanel() {
  return <section aria-label="小工具列表" className="tools-panel">
    <div className="tools-summary"><span>2 个工具</span><span>电脑与手机均可进入</span></div>
    <div className="tools-grid">
      <Link href="/tools/shattered-pixel-dungeon" prefetch={false} className="tool-card-link">
        <Card hoverable className="tool-card">
          <div className="tool-card-heading"><Image src="/tool-icons/shattered-pixel-dungeon.png" alt="" width={64} height={64} unoptimized /><Tag>游戏</Tag></div>
          <h2>破碎的像素地牢</h2>
          <p>探索随机地牢，寻找装备，在回合制冒险中迎接下一次挑战。</p>
          <div className="tool-card-meta">键盘、鼠标与触屏操作</div>
          <div className="tool-card-action"><span>进入工具</span><ArrowRightOutlined /></div>
        </Card>
      </Link>
      <Link href="/tools/conversion" prefetch={false} className="tool-card-link">
        <Card hoverable className="tool-card">
          <div className="tool-card-heading"><span className={styles.toolIcon}><FileSyncOutlined aria-hidden /></span><Tag>文件处理</Tag></div>
          <h2>格式转换</h2>
          <p>转换文档、图片、音视频与 NCM 文件，选择合适的引擎并下载结果。</p>
          <div className="tool-card-meta">一次上传，多次转换 · 文件临时保留 24 小时</div>
          <div className="tool-card-action"><span>进入工具</span><ArrowRightOutlined /></div>
        </Card>
      </Link>
    </div>
  </section>;
}
