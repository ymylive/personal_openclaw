from __future__ import annotations


def build_morning_analysis(report_text: str) -> str:
    return "\n".join(
        [
            report_text.strip(),
            "",
            "【金融晨间分析】",
            "本次推送仅包含金融相关内容，不包含运营推广信息。",
        ]
    )
