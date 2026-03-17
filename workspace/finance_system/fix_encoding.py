#!/usr/bin/env python3
"""修复 report_bot.py 中被破坏的中文字符串"""
from pathlib import Path

cur_path = Path('/home/node/.openclaw/workspace/finance_system/report_bot.py')
cur = cur_path.read_text(encoding='utf-8')
lines = cur.splitlines()

# 需要修复的行号（1-indexed）-> 正确内容
fixes = {
    104: '        return "未知"',
    209: '            title = clean_text(match.group(1)).replace("- 金十数据", "").strip(" -")',
    216: '                    "source": "金十数据",',
    629: '    lines = [f"【龙虾重要新闻总结】{dt}（过去24小时）", ""]',
    631: '    lines.append("一、金十数据快讯（过去24小时）")',
    637: '        lines.append("- 暂未抓取到金十快讯。")',
    640: '    lines.append("二、全球市场重点（过去24小时）")',
    646: '        lines.append("- 暂未抓取到网页新闻。")',
    649: '    lines.append("三、行动提示")',
    650: '    lines.append("- 先看事件时间窗（数据/央行/财报），再看资产联动。")',
    651: '    lines.append("- 若盘中波动放大，优先降低高波动单一标的暴露。")',
}

# build_investment_advice 函数的修复
fixes.update({
    672: '                f"{strongest[2]}近60日动量最强，建议关注 {strongest[3][\'name\']}({strongest[3][\'symbol\']})，可考虑适度增仓。"',
    676: '                f"{weakest[2]}动量偏弱，建议控制仓位，等待20日动量转正后再加仓。"',
    686: '            f"当前最大持仓 {largest_position[\'name\']}({largest_position[\'symbol\']})占比 {format_pct(largest_position[\'portfolio_pct\'])}，建议适度分散风险。"',
    689: '        advice.append("组合结构合理，维持现有配置 + 关注动量信号变化。")',
    692: '        advice.append("今日换手率偏高，建议检查是否有不必要的频繁调仓。")',
    694: '        advice.append("今日换手率正常，持仓策略稳定。")',
})

# build_noon_report 函数的修复
fixes.update({
    708: '    lines = [f"【龙虾中午金融分析报表】{dt}", ""]',
    710: '    lines.append("一、盈亏概览")',
    712: '        f"- 总资产 {format_usd(analysis.get(\'portfolio_value\', 0.0))}，日收益 {format_signed_pct(analysis.get(\'daily_pnl_pct\', 0.0))}（{format_signed_usd(analysis.get(\'daily_pnl_amount\', 0.0))}）"',
    714: '    lines.append(f"- 今日换手率 {format_pct(analysis.get(\'turnover_pct\', 0.0))}，调仓活跃度。")',
    718: '        lines.append(f"- 品类盈亏 {category_name} {format_signed_usd(pnl_amount)}")',
    722: '            f"- 最佳贡献 {top[\'name\']}({top[\'symbol\']}) {format_signed_pct(top[\'ret_1d\'])}，贡献 {format_signed_usd(top[\'pnl_amount\'])}"',
    727: '            f"- 最大拖累 {weak[\'name\']}({weak[\'symbol\']}) {format_signed_pct(weak[\'ret_1d\'])}，拖累 {format_signed_usd(weak[\'pnl_amount\'])}"',
    731: '    lines.append("二、市场温度（1日 / 20日 / 60日）")',
    736: '            lines.append(f"- {category[\'name\']}：暂无可用行情")',
    740: '            f"- {category[\'name\']}：领跑 {leader[\'name\']}({leader[\'symbol\']})，1D {format_pct(leader[\'ret_1d\'])} / 20D {format_pct(leader[\'ret_20d\'])} / 60D {format_pct(leader[\'ret_60d\'])}"',
    744: '    lines.append(f"三、AI模拟持仓（总资产 {format_usd(state.get(\'portfolio_value\', 0.0))}）")',
    749: '            f"- {category[\'name\']}：占比 {format_pct(float(detail.get(\'category_pct\', 0.0)))}"',
    753: '            lines.append("  · 暂无可投资标的")',
    757: '                f"  · {item[\'name\']}({item[\'symbol\']})：占该子品类 {format_pct(float(item[\'category_pct\']))}，占总组合 {format_pct(float(item[\'portfolio_pct\']))}"',
    761: '    lines.append("四、过去24小时新闻")',
    769: '        lines.append("- 暂无过去24小时新闻。")',
    772: '    lines.append("五、投资建议")',
    777: '    lines.append("六、风险提示")',
    778: '    lines.append("- 本报表为模拟与信息整理，不构成投资建议。")',
})

# 应用修复
fixed_count = 0
for line_no, fix in fixes.items():
    idx = line_no - 1
    if idx < len(lines) and '????' in lines[idx]:
        lines[idx] = fix
        fixed_count += 1

print(f'修复了 {fixed_count} 行')

# 写回文件
new_content = '\n'.join(lines)
cur_path.write_text(new_content, encoding='utf-8')
print('写入完成')