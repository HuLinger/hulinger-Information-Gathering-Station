'use client';

import Image from 'next/image';
import Link from 'next/link';
import { Card, Tag } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';

export default function ToolsPanel() {
  return <section aria-label="小工具列表" className="tools-panel">
    <div className="tools-summary"><span>1 个工具</span><span>电脑与手机均可进入</span></div>
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
    </div>
  </section>;
}
